import { expect, test, type Locator, type Page } from "./fixtures";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * The theme is enforced by a `data-theme` attribute on `<html>` set before first paint,
 * so the assertions here read that attribute rather than a computed style — it is the
 * single source of truth that both the CSS and the toggle write to.
 *
 * The exception is the code palette: jsdom cannot resolve custom properties, so whether
 * the surfaces painted `--code-bg` are actually *readable* can only be checked in a real
 * browser. `apps/web/test/style.test.ts` pins that invariant at the source; the contrast
 * check below catches what a source scan cannot, namely a later rule winning on
 * specificity.
 */

/** The attribute value the page is actually themed by. */
const htmlTheme = (page: Page) =>
  page.evaluate(() => document.documentElement.getAttribute("data-theme"));

/**
 * The computed foreground and background of a rendered element.
 *
 * The background is required to be opaque: a transparent one reads as `rgba(0, 0, 0, 0)`,
 * whose digits `luminance` would happily take as black. Measuring a `<code>` inside a `<pre>`
 * that way passes for the block's own background while proving nothing about it.
 */
async function colorsOf(locator: Locator): Promise<{ color: string; background: string }> {
  const style = await locator.evaluate((node) => {
    const computed = getComputedStyle(node);
    return { color: computed.color, background: computed.backgroundColor };
  });
  expect(style.background, "background is transparent").not.toBe("rgba(0, 0, 0, 0)");
  return style;
}

/** WCAG relative luminance of an `rgb(r, g, b)` colour. */
function luminance(rgb: string): number {
  const channel = (n: number): number => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [...rgb.matchAll(/\d+/g)].map((m) => channel(Number(m[0])));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio between two `rgb(…)` colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

test("theme cycles light → dark → auto and persists across a reload", async ({ page }) => {
  await page.goto("/");
  // Only the preference, not `localStorage.clear()`. The session lives there too now, and
  // wiping it would leave this spec staring at a sign-in form with no theme toggle on it —
  // which is a failure that looks nothing like the thing being tested.
  await page.evaluate(() => localStorage.removeItem("gl-theme"));
  await page.reload();

  // Default when nothing is stored is auto.
  expect(await htmlTheme(page)).toBe("auto");

  const toggle = page.getByTestId("theme-toggle");

  // auto → light
  await toggle.click();
  expect(await htmlTheme(page)).toBe("light");

  // light → dark
  await toggle.click();
  expect(await htmlTheme(page)).toBe("dark");

  // dark → auto, and the choice survives a reload (read by the inline pre-paint script).
  await toggle.click();
  expect(await htmlTheme(page)).toBe("auto");

  await page.reload();
  expect(await htmlTheme(page)).toBe("auto");
});

test("a forced theme is applied on reload before the bundle loads", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("gl-theme", "dark"));
  await page.reload();

  // If the inline script did not run, this would be "auto" or, worse, flash dark-then-auto.
  expect(await htmlTheme(page)).toBe("dark");

  // The document also advertises a dark scheme so native controls match.
  const scheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  expect(scheme).toBe("dark");
});

test("a light theme flips the palette", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("gl-theme", "light");
    document.documentElement.setAttribute("data-theme", "light");
  });

  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  // The dark default is #16181c (near-black); light is white. Reading the resolved body
  // colour proves the variable actually flipped, not just the attribute.
  expect(bg).toBe("rgb(255, 255, 255)");
});

test("code surfaces flip with the theme and stay readable in both", async ({ page, request }) => {
  // Inline code and a fenced, syntax-highlighted block — the two shapes that regressed,
  // because they inherited `--text` on a background that never flipped.
  await scriptLlm(request, {
    turns: [{ content: "先跑 `pnpm install`。\n\n```bash\npnpm install --frozen-lockfile\n```\n" }],
  });

  await page.goto("/");
  await enterWorkspace(page);
  await page.getByTestId("composer-input").fill("怎么安装");
  await page.getByTestId("composer-send").click();

  const content = page.getByTestId("message-assistant").last().getByTestId("message-content");
  await expect(content).toContainText("pnpm install");

  // Inline code carries its own background; for the fenced block it is the `<pre>` that
  // does (the `<code>` inside is `transparent`, see `colorsOf`).
  const surfaces: [string, Locator][] = [
    ["inline code", content.locator("p code").first()],
    ["fenced block", content.locator("pre").first()],
  ];

  const readAll = async () => {
    const seen: { color: string; background: string }[] = [];
    for (const [, surface] of surfaces) seen.push(await colorsOf(surface));
    return seen;
  };

  // Through the real toggle rather than by writing the attribute, so the whole path runs —
  // including the syntax stylesheet `composables/theme.ts` swaps on the resolved theme. It
  // cycles light → dark → auto, so this clicks on until the wanted theme is the attribute;
  // counting clicks instead would depend on where the previous assertion left the cycle.
  const toggle = page.getByTestId("theme-toggle");
  const show = async (wanted: "light" | "dark") => {
    for (let i = 0; i < 3 && (await htmlTheme(page)) !== wanted; i++) await toggle.click();
    expect(await htmlTheme(page)).toBe(wanted);
  };

  await show("light");
  const light = await readAll();
  await show("dark");
  const dark = await readAll();

  surfaces.forEach(([name], i) => {
    const onLight = light[i]!;
    const onDark = dark[i]!;

    // The palette flips. An earlier version pinned the code background dark in both themes
    // while the text colour followed the theme: inline code was `#1f2328` on `#0d1117`,
    // about 1.2:1 — invisible rather than merely dim.
    expect(onLight.background, `${name} background`).not.toBe(onDark.background);
    // Dark text on a light block in light, and the reverse in dark.
    expect(luminance(onLight.background), name).toBeGreaterThan(luminance(onLight.color));
    expect(luminance(onDark.background), name).toBeLessThan(luminance(onDark.color));

    expect.soft(contrast(onLight.color, onLight.background), `${name}: light`).toBeGreaterThan(4.5);
    expect.soft(contrast(onDark.color, onDark.background), `${name}: dark`).toBeGreaterThan(4.5);
  });
});

test("the dialog scrim dims less in the light theme than in the dark one", async ({ page }) => {
  // The scrim was `rgba(0, 0, 0, 0.55)` in both themes. Over a white page that composites
  // everything to `#737373` — the sidebar and topbar boundaries disappear and the page reads
  // as if the theme flipped rather than as if a dialog opened. `style.test.ts` pins that the
  // token has two values; this pins the rendered alpha, which a later rule could override.
  const alpha = async () => {
    const value = await page
      .locator(".modal-overlay")
      .evaluate((node) => getComputedStyle(node).backgroundColor);
    const match = /rgba?\([^)]*?,\s*([\d.]+)\s*\)/.exec(value);
    return match ? Number(match[1]) : 1;
  };

  // The theme is chosen *before* the dialog opens: the scrim covers the whole viewport and
  // intercepts the toggle, which is why this cannot simply switch themes with it up.
  const show = async (wanted: "light" | "dark") => {
    const toggle = page.getByTestId("theme-toggle");
    for (let i = 0; i < 4; i++) {
      if ((await htmlTheme(page)) === wanted) break;
      await toggle.click();
    }
    expect(await htmlTheme(page)).toBe(wanted);
  };

  await page.goto("/");
  // The preference only — see the note in the first test. This one needs `open-settings` on
  // screen afterwards, so wiping the session would fail it on a missing button.
  await page.evaluate(() => localStorage.removeItem("gl-theme"));
  await page.reload();

  await show("dark");
  await page.getByTestId("open-settings").click();
  await expect(page.locator(".modal-overlay")).toBeVisible();
  const dark = await alpha();
  await page.locator(".modal-overlay").click({ position: { x: 8, y: 8 } });
  await expect(page.locator(".modal-overlay")).toHaveCount(0);

  await show("light");
  await page.getByTestId("open-settings").click();
  await expect(page.locator(".modal-overlay")).toBeVisible();
  const light = await alpha();

  expect(dark, "the dark scrim should stay heavy").toBeGreaterThan(0.4);
  expect(light, "the light scrim should be much lighter").toBeLessThan(0.4);
  expect(light).toBeLessThan(dark);
});

test("the user bubble flips with the theme and stays readable in both", async ({
  page,
  request,
}) => {
  // The bubble painted its background as a literal navy, so it kept the dark theme's colour
  // on a white page. It looked correct in dark — which is why it survived review for so long
  // — and it was unreadable in light. `style.test.ts` could not see it either: the literal
  // was not a palette value, because there was no `--bubble-bg` for it to restate. Making the
  // surface a token is what makes the source scan able to catch a regression; this is what
  // catches it *rendered*, including a later rule winning on specificity.
  await scriptLlm(request, { turns: [{ content: "好的。" }] });

  await page.goto("/");
  await enterWorkspace(page);
  await page.getByTestId("composer-input").fill("气泡测试");
  await page.getByTestId("composer-send").click();

  const bubble = page.getByTestId("message-user").last().locator(".bubble");
  await expect(bubble).toContainText("气泡测试");

  // Through the real toggle rather than by writing the attribute, so the whole path runs.
  const toggle = page.getByTestId("theme-toggle");
  const show = async (wanted: "light" | "dark") => {
    for (let i = 0; i < 3 && (await htmlTheme(page)) !== wanted; i++) await toggle.click();
    expect(await htmlTheme(page)).toBe(wanted);
  };

  await show("light");
  const light = await colorsOf(bubble);
  await show("dark");
  const dark = await colorsOf(bubble);

  expect(light.background).not.toBe(dark.background);
  // The polarity flips, not merely the value: a light bubble with dark text, and the
  // reverse in dark. A frozen literal fails this in one direction or the other — which is
  // exactly the shape the bug had.
  expect(luminance(light.background), "bubble: light").toBeGreaterThan(luminance(light.color));
  expect(luminance(dark.background), "bubble: dark").toBeLessThan(luminance(dark.color));

  expect.soft(contrast(light.color, light.background), "bubble: light").toBeGreaterThan(4.5);
  expect.soft(contrast(dark.color, dark.background), "bubble: dark").toBeGreaterThan(4.5);
});