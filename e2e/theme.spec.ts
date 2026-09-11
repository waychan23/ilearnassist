import { expect, test, type Page } from "@playwright/test";

/**
 * The theme is enforced by a `data-theme` attribute on `<html>` set before first paint,
 * so the assertions here read that attribute rather than a computed style — it is the
 * single source of truth that both the CSS and the toggle write to.
 */

/** The attribute value the page is actually themed by. */
const htmlTheme = (page: Page) =>
  page.evaluate(() => document.documentElement.getAttribute("data-theme"));

test("theme cycles light → dark → auto and persists across a reload", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
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