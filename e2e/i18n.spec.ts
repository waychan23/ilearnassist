import { expect, test, type Page } from "@playwright/test";

/**
 * Language selection in a real browser.
 *
 * The rest of the suite runs with `locale: "zh-CN"` pinned in `playwright.config.ts`, so
 * this is the only place the *detection* path and the switcher are exercised — the specs
 * that only navigate and assert Chinese text would pass even if detection were broken.
 *
 * `<html lang>` is read rather than a visible string: it is the single thing both the
 * inline pre-paint script and `composables/locale.ts` write, exactly like `data-theme`
 * in `theme.spec.ts`.
 */

/** The language the page is actually running in. */
const htmlLang = (page: Page) => page.evaluate(() => document.documentElement.lang);

/** The theme toggle's tooltip, which is a translated message and so proves the catalog. */
const themeTitle = (page: Page) => page.getByTestId("theme-toggle").getAttribute("title");

test("a Chinese browser gets Chinese, and the choice survives a switch to English", async ({
  page,
}) => {
  await page.goto("/");

  expect(await htmlLang(page)).toBe("zh-CN");
  expect(await themeTitle(page)).toContain("主题：");

  await page.getByTestId("locale-select").selectOption("en");

  expect(await htmlLang(page)).toBe("en");
  expect(await themeTitle(page)).toContain("Theme:");

  // The stored choice outranks the browser's preference, and is read back by the inline
  // script before the bundle loads.
  await page.reload();
  expect(await htmlLang(page)).toBe("en");
  expect(await page.getByTestId("locale-select").inputValue()).toBe("en");
});

test("the switcher reflects the detected language on first load", async ({ page }) => {
  await page.goto("/");
  expect(await page.getByTestId("locale-select").inputValue()).toBe("zh-CN");
});

test.describe("with an English browser", () => {
  test.use({ locale: "en-US" });

  test("renders English and switches to Chinese", async ({ page }) => {
    await page.goto("/");

    expect(await htmlLang(page)).toBe("en");
    expect(await themeTitle(page)).toContain("Theme:");

    await page.getByTestId("locale-select").selectOption("zh-CN");

    expect(await htmlLang(page)).toBe("zh-CN");
    expect(await themeTitle(page)).toContain("主题：");
  });
});

test.describe("with a browser language we do not ship", () => {
  test.use({ locale: "fr-FR" });

  test("falls back to English rather than to Chinese", async ({ page }) => {
    // The requirement, guarded: an unsupported language must land on English.
    await page.goto("/");

    expect(await htmlLang(page)).toBe("en");
    expect(await themeTitle(page)).toContain("Theme:");
  });
});
