import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ServerStatus } from "../apps/desktop/src/shared/panelApi.js";

/**
 * The desktop control panel's page, in a real browser.
 *
 * It runs against the *built* bundle rather than the source, and it does not launch
 * Electron: the panel's own code is a page plus a bundle, and what it needs from Electron is
 * exactly one object on `window`. Stubbing that object is what makes the page testable at
 * all, and it is the right seam — everything above the boundary (`ServerProcess`, the IPC
 * handlers) is already covered by `apps/desktop/test/`, against real child processes.
 *
 * The reason this exists rather than a jsdom test is the first assertion in the second
 * block. jsdom has no layout engine and no cascade, so it cannot tell whether `hidden`
 * actually hides anything — and a `display: flex` in the stylesheet overriding the attribute
 * is precisely the bug that shipped once: the address row kept its "copy" button, next to no
 * address, every time a start failed.
 *
 * `pnpm test:e2e` bundles the panel first; the global `locale: "zh-CN"` pin in
 * `playwright.config.ts` means the panel detects Chinese the same way the app does.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PANEL_URL = pathToFileURL(join(ROOT, "apps/desktop/dist/renderer/index.html")).href;

const RUNNING: ServerStatus = {
  state: "running",
  url: "http://127.0.0.1:51452",
  fault: null,
  dataDir: "/Users/someone/Library/Application Support/guided-learning",
  logs: ["seeding providers", "[guided-learning] listening on http://127.0.0.1:51452"],
};

const FAILED: ServerStatus = {
  ...RUNNING,
  state: "failed",
  url: null,
  fault: { code: "exited", exitCode: 1, signal: null },
};

/**
 * Load the panel with a stubbed `window.panel`, and return a handle for pushing status
 * changes the way the main process would.
 */
async function openPanel(page: Page, initial: ServerStatus): Promise<{ push(next: ServerStatus): Promise<void>; calls: string[] }> {
  const calls: string[] = [];
  await page.exposeFunction("__record", (name: string) => {
    calls.push(name);
  });

  await page.addInitScript((status: ServerStatus) => {
    const w = window as unknown as Record<string, unknown>;
    w["__status"] = status;
    w["panel"] = {
      getState: async () => w["__status"],
      start: async () => {
        await (w["__record"] as (n: string) => Promise<void>)("start");
        return w["__status"];
      },
      stop: async () => {
        await (w["__record"] as (n: string) => Promise<void>)("stop");
        return w["__status"];
      },
      openApp: async () => {
        await (w["__record"] as (n: string) => Promise<void>)("openApp");
      },
      openInBrowser: async () => {},
      revealDataDir: async () => {},
      quit: async () => {},
      onStateChange: (listener: (s: ServerStatus) => void) => {
        w["__push"] = listener;
        return () => undefined;
      },
    };
  }, initial);

  await page.goto(PANEL_URL);

  return {
    calls,
    push: async (next) => {
      await page.evaluate((status) => {
        const w = window as unknown as Record<string, unknown>;
        w["__status"] = status;
        (w["__push"] as (s: ServerStatus) => void)(status);
      }, next);
    },
  };
}

const status = (page: Page) => page.locator(".status");

test.describe("the control panel", () => {
  test.use({ viewport: { width: 480, height: 640 } });

  test("shows a running server with the address it came up on", async ({ page }) => {
    await openPanel(page, RUNNING);

    await expect(page.locator('[data-role="state"]')).toHaveText("运行中");
    await expect(page.locator('[data-role="url"]')).toHaveText(RUNNING.url!);
    await expect(page.locator('[data-role="detail"]')).toBeHidden();
  });

  test("offers only the actions that make sense for the state", async ({ page }) => {
    await openPanel(page, RUNNING);

    await expect(page.locator('[data-action="open"]')).toBeEnabled();
    // Already up: starting again would do nothing, and stopping is the only move left.
    await expect(page.locator('[data-action="start"]')).toBeDisabled();
    await expect(page.locator('[data-action="stop"]')).toBeEnabled();
  });

  test("will not claim a server is up when it is not", async ({ page }) => {
    const panel = await openPanel(page, RUNNING);
    await panel.push(FAILED);

    await expect(status(page)).toHaveAttribute("data-state", "failed");
    await expect(page.locator('[data-role="state"]')).toHaveText("启动失败");

    // The address row has to go — and this is the assertion jsdom could not make. The row
    // is `display: flex`, so `hidden` alone left the "copy" button on screen with nothing
    // to copy.
    await expect(page.locator('[data-role="url-row"]')).toBeHidden();
    await expect(page.locator('[data-action="copy"]')).toBeHidden();
  });

  test("says why a start failed, in words a user can act on", async ({ page }) => {
    const panel = await openPanel(page, RUNNING);
    await panel.push(FAILED);

    await expect(page.locator('[data-role="detail"]')).toBeVisible();
    await expect(page.locator('[data-role="detail"]')).toContainText("1");
  });

  test("re-enables starting once the server is down", async ({ page }) => {
    const panel = await openPanel(page, RUNNING);
    await panel.push({ ...RUNNING, state: "stopped", url: null });

    await expect(page.locator('[data-action="start"]')).toBeEnabled();
    await expect(page.locator('[data-action="stop"]')).toBeDisabled();
    await expect(page.locator('[data-action="open"]')).toBeDisabled();
  });

  test("keeps the server's output folded away until it is asked for", async ({ page }) => {
    await openPanel(page, RUNNING);

    await expect(page.locator('[data-role="logs"]')).toBeHidden();

    await page.locator('[data-action="logs"]').click();

    await expect(page.locator('[data-action="logs"]')).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('[data-role="logs"]')).toBeVisible();
    await expect(page.locator('[data-role="logs"]')).toContainText("[guided-learning] listening on");
  });

  test("sends the command when a button is pressed", async ({ page }) => {
    const panel = await openPanel(page, { ...RUNNING, state: "stopped", url: null });

    await page.locator('[data-action="start"]').click();
    await expect.poll(() => panel.calls).toContain("start");
  });

  test("names the folder the data lives in", async ({ page }) => {
    await openPanel(page, RUNNING);
    // A user who needs to back up, or to send someone a log, has to be able to find this.
    await expect(page.locator('[data-role="data-dir"]')).toHaveText(RUNNING.dataDir);
  });
});
