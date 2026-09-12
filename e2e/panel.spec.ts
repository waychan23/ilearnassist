import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PanelState } from "../apps/desktop/src/shared/panelApi.js";

/**
 * The desktop control panel's page, in a real browser.
 *
 * It runs against the *built* bundle rather than the source, and it does not launch
 * Electron: the panel's own code is a page plus a bundle, and what it needs from Electron is
 * exactly one object on `window`. Stubbing that object is what makes the page testable at
 * all, and it is the right seam — everything above the boundary (`ServerProcess`, the IPC
 * handlers) is already covered by `apps/desktop/test/`, against real child processes.
 *
 * The reason this exists rather than a jsdom test is `will not claim a server is up when it
 * is not`. jsdom has no layout engine and no cascade, so it cannot tell whether `hidden`
 * actually hides anything — and a `display: flex` in the stylesheet overriding the attribute
 * is precisely the bug that shipped once: the address row kept its "copy" button, next to no
 * address, every time a start failed.
 *
 * `pnpm test:e2e` bundles the panel first; the global `locale: "zh-CN"` pin in
 * `playwright.config.ts` means the panel detects Chinese the same way the app does.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PANEL_URL = pathToFileURL(join(ROOT, "apps/desktop/dist/renderer/index.html")).href;

const LOOPBACK = "http://127.0.0.1:51452";
const LAN_ADDRESS = "192.168.1.42";
const LAN_URL = `http://${LAN_ADDRESS}:51452`;

/** The folder the user chose. Deliberately not under the app's own directory. */
const DATA_DIR = "/Users/someone/Documents/ilearnassist";

const RUNNING: PanelState = {
  server: {
    state: "running",
    url: LOOPBACK,
    fault: null,
    dataDir: DATA_DIR,
    logs: ["seeding providers", `[ilearnassist] listening on ${LOOPBACK}`],
  },
  sharedOnLan: false,
  lanUrl: null,
  lanAddress: LAN_ADDRESS,
  needsDataDir: false,
};

const SHARED: PanelState = { ...RUNNING, sharedOnLan: true, lanUrl: LAN_URL };

/**
 * Before anyone has said where the data goes. The server cannot be started in this state —
 * it refuses to run without a data root — so the panel's job is to ask, and nothing that
 * needs a running server should look available.
 */
const NEEDS_DATA_DIR: PanelState = {
  server: { state: "stopped", url: null, fault: null, dataDir: "", logs: [] },
  sharedOnLan: false,
  lanUrl: null,
  lanAddress: LAN_ADDRESS,
  needsDataDir: true,
};

const FAILED: PanelState = {
  ...RUNNING,
  server: { ...RUNNING.server, state: "failed", url: null, fault: { code: "exited", exitCode: 1, signal: null } },
};

interface PanelHandle {
  push(next: PanelState): Promise<void>;
  calls: string[];
}

/**
 * Load the panel with a stubbed `window.panel`, and return a handle for pushing status
 * changes the way the main process would.
 */
async function openPanel(page: Page, initial: PanelState): Promise<PanelHandle> {
  const calls: string[] = [];
  await page.exposeFunction("__record", (name: string) => {
    calls.push(name);
  });

  await page.addInitScript((status: PanelState) => {
    const w = window as unknown as Record<string, unknown>;
    w["__status"] = status;
    const record = w["__record"] as (name: string) => Promise<void>;
    w["panel"] = {
      getState: async () => w["__status"],
      start: async () => {
        await record("start");
        return w["__status"];
      },
      stop: async () => {
        await record("stop");
        return w["__status"];
      },
      shareOnLan: async (on: boolean) => {
        await record(`shareOnLan:${on}`);
        return w["__status"];
      },
      chooseDataDir: async () => {
        await record("chooseDataDir");
        return w["__status"];
      },
      openApp: async () => {
        await record("openApp");
      },
      openInBrowser: async () => undefined,
      revealDataDir: async () => undefined,
      quit: async () => undefined,
      onStateChange: (listener: (state: PanelState) => void) => {
        w["__push"] = listener;
        return () => undefined;
      },
    };
  }, initial);

  await page.goto(PANEL_URL);

  return {
    calls,
    push: async (next) => {
      await page.evaluate((state) => {
        const w = window as unknown as Record<string, unknown>;
        w["__status"] = state;
        (w["__push"] as (s: PanelState) => void)(state);
      }, next);
    },
  };
}

const status = (page: Page) => page.locator(".status");
const qrSheet = (page: Page) => page.locator('[data-role="qr-overlay"]');

test.describe("the control panel", () => {
  test.use({ viewport: { width: 480, height: 660 } });

  test("shows a running server with the address it came up on", async ({ page }) => {
    await openPanel(page, RUNNING);

    await expect(page.locator('[data-role="state"]')).toHaveText("运行中");
    await expect(page.locator('[data-role="url"]')).toHaveText(LOOPBACK);
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
    await panel.push({ ...RUNNING, server: { ...RUNNING.server, state: "stopped", url: null } });

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
    await expect(page.locator('[data-role="logs"]')).toContainText("[ilearnassist] listening on");
  });

  test("sends the command when a button is pressed", async ({ page }) => {
    const panel = await openPanel(page, { ...RUNNING, server: { ...RUNNING.server, state: "stopped", url: null } });

    await page.locator('[data-action="start"]').click();
    await expect.poll(() => panel.calls).toContain("start");
  });

  test("names the folder the data lives in", async ({ page }) => {
    await openPanel(page, RUNNING);
    // A user who needs to back up, or to send someone a log, has to be able to find this.
    await expect(page.locator('[data-role="data-dir"]')).toHaveText(RUNNING.server.dataDir);
  });

  test("asks where the data should go, and says why nothing is running", async ({ page }) => {
    // The server refuses to start without a data root, so before one is chosen every control
    // that needs it is inert and the row explains itself. An empty path box and a start
    // button that does nothing is what this replaces.
    await openPanel(page, NEEDS_DATA_DIR);

    await expect(page.locator('[data-role="data-dir"]')).toBeHidden();
    await expect(page.locator('[data-role="data-dir-hint"]')).toContainText("数据存放位置");
    await expect(page.locator('[data-action="reveal"]')).toBeDisabled();
    await expect(page.getByRole("button", { name: "选择文件夹…" })).toBeEnabled();
  });

  test("hands the choice to the main process rather than making it", async ({ page }) => {
    // The dialog is native and lives in main, so the page's whole part in this is the ask.
    const panel = await openPanel(page, NEEDS_DATA_DIR);
    await page.getByRole("button", { name: "选择文件夹…" }).click();
    expect(panel.calls).toContain("chooseDataDir");
  });

  test("tells a user that closing the window does not stop the server", async ({ page }) => {
    // The tray is invisible until it is needed, so the one window that can explain it does.
    await openPanel(page, RUNNING);
    await expect(page.locator(".note")).toContainText("菜单栏");
  });

  test("fits every control inside the window, with none below the fold", async ({ page }) => {
    // The window is a fixed size and the panel is a fixed stack of rows, so adding a row is
    // how a control ends up off the bottom edge with nothing to indicate it exists. The log
    // disclosure was already half past the edge when the network row was added.
    await openPanel(page, SHARED);

    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();

    for (const selector of [
      '[data-action="open"]',
      '[data-action="stop"]',
      '[data-action="share"]',
      '[data-action="reveal"]',
      '[data-action="logs"]',
      ".note",
    ]) {
      const box = await page.locator(selector).boundingBox();
      expect(box, selector).not.toBeNull();
      expect(box!.y + box!.height, selector).toBeLessThanOrEqual(viewport!.height);
    }
  });
});

test.describe("opening the app on a phone", () => {
  test.use({ viewport: { width: 480, height: 660 } });

  test("offers the network address only while sharing is on", async ({ page }) => {
    const panel = await openPanel(page, RUNNING);
    await expect(page.locator('[data-role="lan-url"]')).toBeHidden();
    await expect(page.locator('[data-action="unshare"]')).toBeHidden();

    await panel.push(SHARED);

    await expect(page.locator('[data-role="lan-url"]')).toHaveText(LAN_URL);
    await expect(page.locator('[data-action="unshare"]')).toBeVisible();
  });

  test("draws a scannable code for the network address", async ({ page }) => {
    await openPanel(page, SHARED);

    await page.locator('[data-action="share"]').click();

    await expect(qrSheet(page)).toBeVisible();
    await expect(page.locator('[data-role="qr"] svg')).toBeVisible();
    // The address is written out as well as encoded, for a camera that will not cooperate.
    await expect(page.locator('[data-role="qr-url"]')).toHaveText(LAN_URL);
    // A button with no label is a rectangle: the sheet's copy control shipped blank once.
    await expect(page.locator('[data-action="qr-copy"]')).toHaveText("复制地址");

    // A QR code is mostly modules. A handful of rects would be a code that renders and
    // never scans, which is exactly the failure this asserts against.
    const modules = await page.locator('[data-role="qr"] rect, [data-role="qr"] g rect').count();
    expect(modules).toBeGreaterThan(40);
  });

  test("turns sharing on rather than showing a code that cannot work", async ({ page }) => {
    // The panel is loopback-only until this is pressed, so a code drawn from the current
    // state would encode 127.0.0.1 and send the phone to its own loopback.
    const panel = await openPanel(page, RUNNING);

    await page.locator('[data-action="share"]').click();

    await expect.poll(() => panel.calls).toContain("shareOnLan:true");
    // Until the restart lands there is genuinely nothing to scan, and the sheet says so
    // rather than leaving a blank square.
    await expect(page.locator('[data-role="qr-message"]')).toBeVisible();
    await expect(page.locator('[data-role="qr"]')).toBeHidden();

    await panel.push(SHARED);

    await expect(page.locator('[data-role="qr"] svg')).toBeVisible();
    await expect(page.locator('[data-role="qr-message"]')).toBeHidden();
  });

  test("says so when there is no network address to offer", async ({ page }) => {
    // A machine on no network cannot be reached from a phone, and a QR encoding a
    // loopback address would look like it worked.
    await openPanel(page, { ...SHARED, lanUrl: null, lanAddress: null });

    await page.locator('[data-action="share"]').click();

    await expect(page.locator('[data-role="qr-message"]')).toContainText("局域网地址");
    await expect(page.locator('[data-role="qr"]')).toBeHidden();
  });

  test("closes on Escape, so a modal does not trap a keyboard user", async ({ page }) => {
    await openPanel(page, SHARED);
    await page.locator('[data-action="share"]').click();
    await expect(qrSheet(page)).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(qrSheet(page)).toBeHidden();
  });

  test("turns sharing off from the panel, without opening the sheet", async ({ page }) => {
    const panel = await openPanel(page, SHARED);

    await page.locator('[data-action="unshare"]').click();

    await expect.poll(() => panel.calls).toContain("shareOnLan:false");
    await expect(qrSheet(page)).toBeHidden();
  });
});
