import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures";
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

test("layout: the message column reserves both scrollbar gutters", async ({ page, request }) => {
  /*
   * A long conversation scrolls, and the sheet's `::-webkit-scrollbar` is a **classic** bar — so
   * in a real browser it takes 8px of layout off the right-hand edge and every message gutter
   * comes out unequal: 12px on the left, 20px on the right.
   *
   * What that costs a test is worth stating, because the assertion below is not the one you would
   * expect: **headless Chromium gives overlay scrollbars here** — `offsetWidth` and `clientWidth`
   * agree even with the list overflowing — so the visible asymmetry cannot be reproduced at all.
   * Deleting the declaration therefore has to fail this case some other way, and that way is the
   * computed value. The gap check is kept beside it as the invariant the declaration is for.
   */
  await converse(page, request, "很长的一句话。".repeat(200));
  const scroller = page.locator(".messages");
  await expect(scroller).toBeVisible();

  const measured = await scroller.evaluate((el) => {
    const body = document.querySelector(".msg .body") as HTMLElement;
    const sr = el.getBoundingClientRect();
    const br = body.getBoundingClientRect();
    return {
      overflows: el.scrollHeight > el.clientHeight,
      gutter: getComputedStyle(el).scrollbarGutter,
      leftGap: Math.round(br.left - sr.left),
      rightGap: Math.round(sr.right - br.right),
    };
  });

  // The case is real: without overflow there is no scrollbar and nothing to be asymmetric about.
  expect(measured.overflows).toBe(true);
  expect(measured.gutter).toBe("stable both-edges");
  expect(measured.leftGap).toBe(measured.rightGap);
});

test("layout: the reply gives up its avatar and its gutters, and takes them back", async ({
  page,
  request,
}) => {
  /*
   * A reply carried a 30px avatar, a 12px gap and 24px of padding on each side — 90px of a 412px
   * screen, spent before a word was set. Both halves are asserted, because "more compact" has a
   * direction: the avatar has to be *gone* and the text has to be *wider*, and a rule that only
   * shrank the avatar would satisfy neither the ask nor the width.
   */
  await converse(page, request, "你好");

  const reply = page.getByTestId("message-assistant").last();
  await expect(reply.locator(".avatar")).toBeHidden();

  /*
   * 412 less the column's two gutters — `--space-6` of padding and an 8px reserved scrollbar
   * gutter, on each side. The body is the flex item, so with the avatar gone it is the whole of
   * that width, which makes this a statement about both changes at once.
   *
   * The reserve is what the case above is about and it is not free: it costs 16px of the 66px
   * this change won, so the column lands at 372 rather than 388. Spending part of a compactness
   * gain on symmetry is the decision; the sheet's 8px scrollbar is the bar it is spent on.
   */
  const body = (await reply.locator(".body").boundingBox())!;
  expect(body.width).toBeCloseTo(412 - 2 * (12 + 8), 0);

  // The user's own turn keeps its avatar-free shape for a different reason — it never had one —
  // and its bubble still stops short of the edge rather than being stretched by the new gutter.
  const bubble = (await page.getByTestId("message-user").last().locator(".bubble").boundingBox())!;
  expect(bubble.width).toBeLessThan(388);

  /*
   * And it is a rule about this width, not about the app. Read after a resize rather than in a
   * desktop spec, which is where the rest of this file's "state that is only read once" cases
   * live: `display: none` cannot get stuck the way a JavaScript flag can, and the assertion is
   * here to say so.
   */
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(reply.locator(".avatar")).toBeVisible();
  // Back, and taking room again: the body is the row's flex item, so it is narrower than the row
  // by the avatar and its gap. Asserted as that relationship rather than against a number, since
  // the desktop column's width is a different question from this one.
  const row = (await reply.boundingBox())!;
  expect((await reply.locator(".body").boundingBox())!.width).toBeLessThan(row.width);
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

test("layout: the workspace home's rail is the same drawer", async ({ page }) => {
  /*
   * The two rails draw the *same* menu from the same component, and on a phone they used to be
   * two different things: a drawer on a conversation and a strip across the top on the home page.
   * Which presentation you got depended on the page you happened to be standing on.
   *
   * The rail is the column it is at a wide width — 272px, off-canvas — and the cards get the rest,
   * which is the assertion that would fail if it had merely been hidden: a hidden rail and a rail
   * still occupying a grid track look identical from `toBeHidden` alone.
   */
  await page.goto("/");
  await expect(page.getByTestId("workspace-home")).toBeVisible();

  const rail = page.locator(".home-rail");
  await expect(rail).toBeHidden();
  expect((await page.locator(".home-main").boundingBox())?.width).toBeCloseTo(412, 0);

  await page.getByTestId("nav-toggle").tap();
  await expect(rail).toBeVisible();
  await expect(page.getByTestId("drawer-backdrop")).toBeVisible();
  // The account's rows are the rail's content, and they are on the drawer rather than in a band.
  await expect(page.getByTestId("menu-group-account")).toBeVisible();

  /*
   * The sidebar's own box, from the edge it is anchored to: 272px wide, the full height, flush
   * against the left. A drawer that slid in from the wrong edge or stopped short of the top
   * would satisfy every assertion above.
   *
   * Polled, because `toBeVisible` is satisfied by the `visibility` flip and the slide is still
   * running under it — measured straight away, `x` reads mid-transform. The height is compared
   * against the *viewport* rather than a device constant, which is what the rest of this file
   * does: the emulated viewport is the layout viewport, and 915 is the screen.
   */
  const boxAt = async () => (await rail.boundingBox())!;
  await expect.poll(async () => Math.round((await boxAt()).x)).toBe(0);
  await expect.poll(async () => Math.round((await boxAt()).width)).toBe(272);
  await expect.poll(async () => Math.round((await boxAt()).height)).toBe(
    Math.round(page.viewportSize()!.height)
  );

  await page.getByTestId("drawer-backdrop").tap({ position: { x: 380, y: 400 } });
  await expect(rail).toBeHidden();
});

test("layout: focus enters the home drawer, and Escape brings it back", async ({ page }) => {
  /*
   * `App.vue`'s focus watcher names its open target by test id, and the chat page's targets do
   * not exist here — so this is the case that fails silently if the menu rows are not in that
   * selector: the drawer slides open with the caret left behind on the page underneath it.
   */
  await page.goto("/");
  await expect(page.getByTestId("workspace-home")).toBeVisible();

  await page.getByTestId("nav-toggle").tap();
  expect(
    await page.evaluate(() => document.activeElement?.closest(".home-rail") !== null),
  ).toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.locator(".home-rail")).toBeHidden();
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(
    "nav-toggle",
  );
});

test("layout: the closed home rail is not reachable by keyboard", async ({ page }) => {
  // The same `visibility: hidden` the sidebar relies on, and the same failure without it: the
  // brand and every menu row focusable, off-screen and announced.
  await page.goto("/");
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  await expect(page.locator(".home-rail")).toBeHidden();

  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(
      () => document.activeElement?.closest(".home-rail") !== null,
    );
    expect(inside, `focus entered the closed drawer after ${i + 1} tabs`).toBe(false);
  }
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
  // `visibility: hidden` on the closed panel is what keeps its all-workspaces row, its glyph
  // buttons, every session row and the settings entry out of the tab order. Without it they
  // are focusable and announced while off-screen.
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

test("layout: the widget panel is a drawer at the right", async ({ page, request }) => {
  /*
   * The panel is a third *column* on a wide screen and a fixed overlay here — the same element,
   * laid out by a media query, which is why `App.vue` withholds `with-widgets` at this width: the
   * class would add a grid track the drawer does not occupy.
   *
   * Its install is seeded over HTTP rather than through the dialog, because what is being tested
   * here is the *layout*, and going through four dialogs to arrange it would make this a test of
   * something else.
   */
  await converse(page, request, "你好");

  const workspaces = await (await request.get("/api/workspaces")).json();
  const workspaceId = workspaces[0].id;
  const installed = await request.put(
    `/api/workspaces/${workspaceId}/widgets/workspace_stats`,
    { data: { enabled: true } },
  );
  expect(installed.ok()).toBe(true);

  await page.reload();
  await enterWorkspace(page);

  // Off-canvas until asked for, and the control that asks is the topbar's **last** control —
  // where the panel it opens appears, rather than beside the nav toggle at the other edge.
  await expect(page.getByTestId("widget-toggle")).toBeVisible();
  await expect(page.getByTestId("widget-panel")).toBeHidden();

  const toggleBox = (await page.getByTestId("widget-toggle").boundingBox())!;
  const navBox = (await page.getByTestId("nav-toggle").boundingBox())!;
  expect(toggleBox.x).toBeGreaterThan(navBox.x);
  // And it grows with its neighbours under a finger, rather than being the one topbar control
  // that stayed small.
  expect(toggleBox.width).toBeGreaterThanOrEqual(44);
  expect(toggleBox.height).toBeGreaterThanOrEqual(44);
  // Nothing to its right but the topbar's own padding, and the theme/locale controls are to its
  // left — which is the whole of "far right" and what a reordering would break.
  const topbarBox = (await page.locator(".topbar").boundingBox())!;
  expect(topbarBox.x + topbarBox.width - (toggleBox.x + toggleBox.width)).toBeLessThan(20);

  await page.getByTestId("widget-toggle").tap();
  await expect(page.getByTestId("widget-panel")).toBeVisible();
  await expect(page.getByTestId("widget-drawer-backdrop")).toBeVisible();

  // It fits the screen: a fixed overlay wider than the viewport would be a panel nobody can
  // dismiss, and the whole point of the width being capped against `vw` rather than fixed.
  expect((await page.getByTestId("widget-panel").boundingBox())!.width).toBeLessThanOrEqual(412);

  /*
   * Polled rather than measured once, because the panel *slides*: `visibility` flips on the tap
   * while the transform animates over `--dur-slow`, so a single reading catches it part-way in
   * and reports a right edge it will never have at rest. This is the assertion that would catch a
   * panel genuinely hanging off the edge.
   */
  await expect
    .poll(async () => {
      const box = (await page.getByTestId("widget-panel").boundingBox())!;
      return Math.round(box.x + box.width);
    })
    .toBeLessThanOrEqual(412);

  // Nor does it add to the page's own scroll width while closed, which is what the other
  // overflow assertions on this file would catch.
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(overflow).toEqual({ scroll: 412, client: 412 });

  // The backdrop dismisses it, and the drag handle is not offered — a fixed overlay has no width
  // to drag.
  await expect(page.getByTestId("widget-resize")).toHaveCount(0);
  await page.getByTestId("widget-drawer-backdrop").tap({ position: { x: 20, y: 400 } });
  await expect(page.getByTestId("widget-panel")).toBeHidden();
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
  await page.getByTestId("open-copilots").tap();

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

  // The Copilot list lives in the sidebar's footer, which is a drawer at this width.
  await page.getByTestId("nav-toggle").tap();
  await page.getByTestId("open-copilots").tap();

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

/** A workspace of its own with one file in it, entered with the files panel open. */
async function drawerFiles(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
  name: string,
) {
  const res = await request.post("/api/workspaces", { data: { name } });
  expect(res.status()).toBe(201);
  const { workdirPath } = (await res.json()) as { workdirPath: string };
  writeFileSync(join(workdirPath, "notes.txt"), "内容");

  await page.goto("/");
  await enterWorkspace(page, name);
  await page.getByTestId("nav-toggle").tap();
  await page.getByTestId("sidebar-tab-files").tap();
  await expect(page.getByTestId("file-row").first()).toBeVisible();
}

test("layout: the file preview is a bottom sheet that fits the screen", async ({ page, request }) => {
  // The teleport check for the second overlay the sidebar can open. The drawer is
  // `position: fixed` inside a `transform`, so a `.modal-overlay` left inside it would be laid
  // out in the off-canvas panel and render off-screen — and the file tree lives in exactly
  // that panel, which is what makes this the case worth pinning.
  await drawerFiles(page, request, "抽屉预览");

  const row = page.getByTestId("file-row").first();
  // The phone's row is the 44px one, so the tap lands rather than missing a 26px target.
  expect((await row.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await row.tap();

  const dialog = page.locator("body > .modal-overlay");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("file-preview-text")).toHaveText("内容");

  // Asserting the parent is `body` is the actual invariant; the box is the narrow-screen
  // polish on top of it.
  const box = await dialog.locator(".modal").boundingBox();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect(box?.width ?? 0).toBeLessThanOrEqual(412);

  /*
   * And the maximise control is not offered here at all. At this width the dialog is already a
   * full-width sheet sized to `92dvh`, so the control could only be a no-op — and a control that
   * renders but does nothing is worse than no control. Asserted where the breakpoint is real
   * rather than in a desktop spec with a resized window.
   */
  await expect(page.getByTestId("file-preview-maximize")).toHaveCount(0);
});

test("layout: one Escape closes the file preview, not the drawer under it", async ({
  page,
  request,
}) => {
  // The same guard the confirm prompt has, for the same reason: `FilePreviewDialog` listens on
  // `window` for Escape too, so without `App.vue` returning early the dialog closes *and* the
  // panel holding the tree slides away underneath it — leaving the user outside the drawer
  // they were browsing from.
  await drawerFiles(page, request, "抽屉退出");
  await page.getByTestId("file-row").first().tap();
  await expect(page.locator("body > .modal-overlay")).toBeVisible();

  await page.keyboard.press("Escape");

  await expect(page.locator("body > .modal-overlay")).toHaveCount(0);
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect(page.getByTestId("file-tree")).toBeVisible();
});
