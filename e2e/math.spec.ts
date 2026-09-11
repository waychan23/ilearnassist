import { expect, test, type Page } from "@playwright/test";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * Formulas, in a real browser.
 *
 * `apps/web/test/utils/markdown.test.ts` pins what `renderMarkdown` produces. What it
 * cannot see is the *stylesheet*: KaTeX draws its glyphs with its own fonts, and
 * `katex.min.css` is the one thing in that pipeline imported from a package rather than
 * written here. A dropped import still emits a `.katex` element and still passes every
 * unit test, and shows up as a formula set in the browser's serif fallback with the
 * fractions and radicals collapsed. Reading the computed `font-family` is what makes that
 * failure visible, which is the same reasoning as `theme.spec.ts`'s contrast checks.
 */

/** The attribute value the page is actually themed by. */
const htmlTheme = (page: Page) =>
  page.evaluate(() => document.documentElement.getAttribute("data-theme"));

test("a reply's formulas render as KaTeX, in both themes", async ({ page, request }) => {
  await scriptLlm(request, {
    turns: [
      {
        content:
          "质能方程 $E = mc^2$ 很简单，但下面这个不是：\n\n" +
          "$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$\n",
      },
    ],
  });

  await page.goto("/");
  await enterWorkspace(page);
  await page.getByTestId("composer-input").fill("解释一下质能方程");
  await page.getByTestId("composer-send").click();

  const content = page.getByTestId("message-assistant").last().getByTestId("message-content");
  await expect(content).toContainText("质能方程");

  // Inline and display math are separate rules in the plugin and separate output shapes —
  // `.katex` inline, `.katex-display` inside the paragraph a `$$` block replaces. Only
  // checking one of them would leave the other free to regress.
  const inline = content.locator(".katex").first();
  await expect(inline).toBeVisible();
  await expect(content.locator(".katex-block .katex-display").first()).toBeVisible();

  // The formula parsed. A failure renders as `.katex-error` with the source in a danger
  // colour instead, which is a *rendered* thing — markdown.test.ts pins the same class,
  // but only here does it prove the reply reached the page intact.
  await expect(content.locator(".katex-error")).toHaveCount(0);

  // `katex.min.css` reached the page. Without it this is the inherited UI font.
  const family = await inline.evaluate((node) => getComputedStyle(node).fontFamily);
  expect(family).toContain("KaTeX_Main");

  // KaTeX's glyphs carry no colour of their own, so they inherit `--text` and follow the
  // theme with nothing to swap — unlike the highlight.js sheet. A formula frozen to one
  // theme's colour is exactly the failure `theme.spec.ts` exists to catch, so it is
  // pinned here too rather than assumed from the fact that the vendor sheet sets none.
  const colorOf = () => inline.evaluate((node) => getComputedStyle(node).color);
  const toggle = page.getByTestId("theme-toggle");
  const show = async (wanted: "light" | "dark") => {
    // Through the real toggle rather than by writing the attribute, so the whole path runs.
    for (let i = 0; i < 3 && (await htmlTheme(page)) !== wanted; i++) await toggle.click();
    expect(await htmlTheme(page)).toBe(wanted);
  };

  await show("light");
  const light = await colorOf();
  await show("dark");
  const dark = await colorOf();

  expect(light).not.toBe(dark);
});
