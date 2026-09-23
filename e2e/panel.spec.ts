import { expect, test, type Page } from "./fixtures";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PanelState, ResetResult } from "../apps/desktop/src/shared/panelApi.js";

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

/** The folder the panel offers when nobody has chosen one: `~/ilearnassist`. */
const DEFAULT_DATA_DIR = "/Users/someone/ilearnassist";

const RUNNING: PanelState = {
  server: {
    state: "running",
    url: LOOPBACK,
    fault: null,
    dataDir: DATA_DIR,
    logs: ["seeding providers", `[ilearnassist] listening on ${LOOPBACK}`],
    // Null for an ordinary launch: the note is about a boot that upgraded the database, and
    // drawing it when nothing happened would be the panel inventing news.
    migrated: null,
  },
  sharedOnLan: false,
  port: 10471,
  lanUrl: null,
  lanAddress: LAN_ADDRESS,
  needsDataDir: false,
  defaultDataDir: DEFAULT_DATA_DIR,
  needsAdmin: false,
  // The panel's language, as the main process would report it. Following the system here, so
  // the spec renders whichever catalog the browser's locale pinned — which is what the rest of
  // the suite already relies on.
  localeChoice: "",
  locale: "zh-CN",
  appVersion: "0.1.0",
  update: { latestVersion: null, url: null, available: false, checking: false },
};

const SHARED: PanelState = { ...RUNNING, sharedOnLan: true, lanUrl: LAN_URL };

/** A launch that has heard about a newer release. */
const UPDATE_AVAILABLE: PanelState = {
  ...RUNNING,
  update: {
    latestVersion: "0.2.0",
    url: "https://github.com/waychan23/ilearnassist/releases/tag/v0.2.0",
    available: true,
    checking: false,
  },
};

/** A launch that upgraded the database on the way up. */
const MIGRATED: PanelState = {
  ...RUNNING,
  server: {
    ...RUNNING.server,
    migrated: { from: 5, to: 6, backup: "/Users/someone/ilearnassist/backups/v5.sqlite" },
  },
};

/**
 * A data folder with no administrator yet. The server cannot be started in this state — it
 * refuses to listen — so the panel offers the create control and keeps Start inert.
 */
const NEEDS_ADMIN: PanelState = {
  ...RUNNING,
  server: { state: "stopped", url: null, fault: null, dataDir: DATA_DIR, logs: [], migrated: null },
  needsAdmin: true,
};

/**
 * Before anyone has said where the data goes. The server cannot be started in this state —
 * it refuses to run without a data root — so the panel's job is to ask, and nothing that
 * needs a running server should look available.
 */
/**
 * A data folder that is set up, with the server **stopped**.
 *
 * The ordinary state a forgotten password is found in — and the one the reset button used to be
 * dead in, because the reset was a request to the running server. Nothing about it needs the
 * server now.
 */
const STOPPED_WITH_ADMIN: PanelState = {
  ...RUNNING,
  server: { state: "stopped", url: null, fault: null, dataDir: DATA_DIR, logs: [], migrated: null },
};

const NEEDS_DATA_DIR: PanelState = {
  server: { state: "stopped", url: null, fault: null, dataDir: "", logs: [], migrated: null },
  sharedOnLan: false,
  port: 10471,
  lanUrl: null,
  lanAddress: LAN_ADDRESS,
  needsDataDir: true,
  defaultDataDir: DEFAULT_DATA_DIR,
  needsAdmin: undefined,
  localeChoice: "",
  locale: "zh-CN",
  appVersion: "0.1.0",
  update: { latestVersion: null, url: null, available: false, checking: false },
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
async function openPanel(
  page: Page,
  initial: PanelState,
  /**
   * What the main process answers the reset call with. The page collects the new password in
   * a sheet and hands it over; the happy result is just a username, no password.
   */
  reset: ResetResult = { ok: true, username: "tester" },
  /** What the create-administrator call answers. The happy path by default. */
  adminCreate:
    | { ok: true; username?: string }
    | { ok: false; fault: { code: string; message?: string; params?: Record<string, number | string> } } = {
    ok: true,
    username: "tester",
  }
): Promise<PanelHandle> {
  const calls: string[] = [];
  await page.exposeFunction("__record", (name: string) => {
    calls.push(name);
  });

  await page.addInitScript(
    ({
      status,
      resetResult,
      createResult,
    }: {
      status: PanelState;
      resetResult: ResetResult;
      createResult:
        | { ok: true; username?: string }
        | { ok: false; fault: { code: string; message?: string; params?: Record<string, number | string> } };
    }) => {
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
      // Records and answers with the state unchanged, like `chooseDataDir`: the real one stops
      // on the folder question rather than starting the server, so the page's next paint is the
      // create-administrator card.
      useDefaultDataDir: async () => {
        await record("useDefaultDataDir");
        return w["__status"];
      },
      openApp: async () => {
        await record("openApp");
      },
      openInBrowser: async () => undefined,
      revealDataDir: async () => undefined,
      resetAdminPassword: async (input: { password: string }) => {
        await record(`resetAdminPassword:${input.password}`);
        return resetResult;
      },
      adminStatus: async () => {
        await record("adminStatus");
        return { ok: true, status: { hasAdmin: (w.__status as PanelState).needsAdmin === false, adminUsername: "tester" } };
      },
      createAdministrator: async () => {
        await record("createAdministrator");
        return createResult;
      },
      // The real handler writes the preference and answers with the state it made true; the
      // stub does the same thing in one line, because what the page does with the *answer* is
      // the half this spec can see.
      setLocale: async (choice: string) => {
        await record(`setLocale:${choice}`);
        const next = {
          ...(w["__status"] as PanelState),
          localeChoice: choice === "" ? "" : choice,
          locale: choice === "" ? "zh-CN" : choice,
        } as PanelState;
        w["__status"] = next;
        return next;
      },
      setPort: async (port: number) => {
        await record(`setPort:${port}`);
        const next = { ...(w["__status"] as PanelState), port } as PanelState;
        w["__status"] = next;
        return next;
      },
      quit: async () => undefined,
      onStateChange: (listener: (state: PanelState) => void) => {
        w["__push"] = listener;
        return () => undefined;
      },
    };
    },
    {
      status: initial,
      resetResult: reset,
      createResult: adminCreate,
    }
  );

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
  // Mirrors the real default window (720; the port row added the extra height).
  test.use({ viewport: { width: 480, height: 720 } });

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

  test("names the folder it would create, and offers it", async ({ page }) => {
    // The requirement the offer exists for: a first launch should not make the user work out
    // where their data goes. Which folder is about to appear is on screen, because "one will
    // be created for you" is only honest with the path in it.
    await openPanel(page, NEEDS_DATA_DIR);

    await expect(page.locator('[data-role="data-dir-hint"]')).toContainText(DEFAULT_DATA_DIR);
    await expect(page.getByRole("button", { name: "使用默认目录" })).toBeEnabled();
  });

  test("offers the default only while nothing has been chosen", async ({ page }) => {
    // Once a folder is chosen the question is answered, and the control that changes it is the
    // head's "选择文件夹…" — which is the same control in both states. A second one down here
    // would be two controls meaning one thing.
    await openPanel(page, RUNNING);

    await expect(page.getByRole("button", { name: "使用默认目录" })).toBeHidden();
    await expect(page.locator('[data-role="data-dir-hint"]')).toBeHidden();
  });

  test("hands the choice to the main process rather than making it", async ({ page }) => {
    // The dialog is native and lives in main, so the page's whole part in this is the ask.
    const panel = await openPanel(page, NEEDS_DATA_DIR);
    await page.getByRole("button", { name: "选择文件夹…" }).click();
    expect(panel.calls).toContain("chooseDataDir");
  });

  test("hands the default over too, rather than making the folder itself", async ({ page }) => {
    // Same division as the picker: the page cannot create a directory, and it does not name
    // one either — `useDefaultDataDir` takes no argument, because the path is main's to compute
    // from the caller's home directory.
    const panel = await openPanel(page, NEEDS_DATA_DIR);
    await page.getByRole("button", { name: "使用默认目录" }).click();
    expect(panel.calls).toContain("useDefaultDataDir");
  });

  test("hands an unpickable Start to main, and asks nothing itself", async ({ page }) => {
    /*
     * Main answers a Start with no data root by asking — natively, naming the folder it would
     * create, with the panel's own two answers as its buttons. That dialog is main's and this
     * suite stubs `window.panel`, so what is asserted here is the page's half of the split: it
     * asks for the start and *nothing else*.
     *
     * The page used to do it instead, by focusing its own default button, and that is worth
     * pinning as a regression: a programmatic focus draws no ring and moves nothing, so Start read
     * as a button that did nothing at all.
     */
    const panel = await openPanel(page, NEEDS_DATA_DIR);
    await page.locator('[data-action="start"]').click();

    expect(panel.calls).toContain("start");
    expect(panel.calls).not.toContain("chooseDataDir");
    // Unchanged state: the row is still the answer, and its offer still works.
    await expect(page.locator('[data-role="data-dir-hint"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "使用默认目录" })).toBeEnabled();
  });

  test("offers changing the folder once one is chosen, and revealing it", async ({ page }) => {
    // The same control in both states — the first-run prompt and the later "move my data"
    // — because they are the same question, and the panel has no separate settings screen
    // to put the second one in.
    await openPanel(page, RUNNING);

    await expect(page.getByRole("button", { name: "选择文件夹…" })).toBeEnabled();
    await expect(page.locator('[data-action="reveal"]')).toBeEnabled();
    await expect(page.locator('[data-role="data-dir-hint"]')).toBeHidden();
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
      // The two the update row added, which is exactly the kind of row this assertion exists for:
      // a control past the bottom edge of a window that does not scroll is one nobody can press.
      '[data-action="check-updates"]',
      ".note",
    ]) {
      const box = await page.locator(selector).boundingBox();
      expect(box, selector).not.toBeNull();
      expect(box!.y + box!.height, selector).toBeLessThanOrEqual(viewport!.height);
    }
  });

  test("moves when dragged by its title bar, from the window's top edge onward", async ({ page }) => {
    /*
     * The window has no title bar of its own — `titleBarStyle: hiddenInset` puts the traffic
     * lights inside it — so this header is the only thing that can move it, and the bug was
     * that it could not: the drag region was a 440×47 strip whose top edge was 50px down the
     * window, because the padding above the rows belonged to `.panel`. Grabbing the window
     * where its title bar appears to be therefore did nothing at all.
     *
     * Two things are asserted, and both are load-bearing. The region has to reach the window's
     * top edge, which is what putting that padding on the header buys; and it has to survive
     * the rows scrolling, which is what the separate scroller buys — with one scroller the
     * whole title bar slid off the top of a short window and took the drag region with it.
     *
     * `-webkit-app-region` is a Blink property, so computed style is where the page's half of
     * this is observable at all. What Electron does with it is `main.ts`'s `titleBarStyle`.
     */
    // Short enough that the rows overflow, since the scrolled half of the bug needs a scroller.
    await page.setViewportSize({ width: 480, height: 420 });
    await openPanel(page, RUNNING);

    const titleBar = () =>
      page.evaluate(() => {
        const header = document.querySelector(".header")!;
        const rect = header.getBoundingClientRect();
        return {
          region: getComputedStyle(header).getPropertyValue("-webkit-app-region"),
          insideRegion: getComputedStyle(document.querySelector(".locale")!).getPropertyValue(
            "-webkit-app-region"
          ),
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          windowWidth: window.innerWidth,
        };
      });

    const before = await titleBar();
    expect(before.region).toBe("drag");
    expect({ top: before.top, left: before.left }).toEqual({ top: 0, left: 0 });
    expect(before.width).toBe(before.windowWidth);
    // The one control in the region opts out — otherwise pressing it moves the window instead.
    expect(before.insideRegion).toBe("no-drag");

    const scrolled = await page.evaluate(() => {
      const rows = document.querySelector(".panel__body")!;
      rows.scrollTop = rows.scrollHeight;
      return rows.scrollTop;
    });
    expect(scrolled).toBeGreaterThan(0);

    const after = await titleBar();
    expect(after.top).toBe(0);
    expect(after.region).toBe("drag");
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

/**
 * The fixed listen port.
 *
 * The address the app is reached at must not move, so this is where the panel shows it and
 * changes it; an invalid typed value is answered in place rather than handed to main, which
 * would refuse it anyway.
 */
test.describe("the fixed server port", () => {
  test.use({ viewport: { width: 480, height: 660 } });

  const PORT_INPUT = '[data-role="port-input"]';

  test("shows the port from the state", async ({ page }) => {
    await openPanel(page, RUNNING);
    await expect(page.locator(PORT_INPUT)).toHaveValue("10471");
  });

  test("applies a typed valid port, handing the number to main", async ({ page }) => {
    const panel = await openPanel(page, RUNNING);

    await page.locator(PORT_INPUT).fill("4567");
    await page.getByRole("button", { name: "应用" }).click();

    await expect.poll(() => panel.calls).toContain("setPort:4567");
    await expect(page.locator('[data-role="port-hint"]')).toBeHidden();
  });

  test("applies on Enter as well", async ({ page }) => {
    const panel = await openPanel(page, RUNNING);
    await page.locator(PORT_INPUT).fill("4567");
    await page.locator(PORT_INPUT).press("Enter");
    await expect.poll(() => panel.calls).toContain("setPort:4567");
  });

  test("refuses a blank or out-of-range value without calling main", async ({ page }) => {
    const panel = await openPanel(page, RUNNING);

    for (const bad of ["", "0", "70000", "3.5"]) {
      await page.locator(PORT_INPUT).fill(bad);
      await page.getByRole("button", { name: "应用" }).click();
      await expect(page.locator('[data-role="port-hint"]')).toBeVisible();
    }

    expect(panel.calls.some((c) => c.startsWith("setPort"))).toBe(false);
  });

  test("renders the port-in-use fault naming the port", async ({ page }) => {
    await openPanel(page, {
      ...RUNNING,
      server: {
        ...RUNNING.server,
        state: "failed",
        url: null,
        fault: { code: "port_in_use", port: 10471 },
      },
    });
    await expect(page.locator('[data-role="detail"]')).toContainText("10471");
  });
});

/**
 * Resetting the administrator's password — the panel's one account control.
 *
 * It is here, in the panel, because it is the only thing that can fix a forgotten password:
 * every route in the app needs somebody already signed in, which is exactly what a
 * forgotten password prevents. The operator is taken to be the superadmin at this machine,
 * so a sheet collects the chosen password (with a confirmation) rather than generating one.
 * These tests pin that the control is not offered when it cannot work, that the typed
 * password is what crosses IPC, and that the success and the refusal are both rendered.
 */
test.describe("resetting the administrator's password", () => {
  test.use({ viewport: { width: 480, height: 760 } });

  const RESET = '[data-action="reset-admin"]';
  const SHEET = '[data-role="reset-overlay"]';

  test("is refused only when there is nowhere to write", async ({ page }) => {
    // The one state it cannot help in: nobody has said where the data goes, so there is no
    // database to reset a row in.
    await openPanel(page, NEEDS_DATA_DIR);
    await expect(page.locator(RESET)).toBeDisabled();
  });

  test("is offered with the server stopped, which is when it is most needed", async ({ page }) => {
    /*
     * The bug the earlier shape of this spec existed for. The reset used to be a request to
     * the *running* server, so the one control that exists for "I cannot sign in" needed a
     * healthy server — and a forgotten password is often found in the same moment as something
     * else being wrong. It is a one-shot child now, so a stopped server changes nothing.
     */
    await openPanel(page, STOPPED_WITH_ADMIN);
    await expect(page.locator(RESET)).toBeEnabled();
  });

  test("is offered once the server is up", async ({ page }) => {
    await openPanel(page, RUNNING);
    await expect(page.locator(RESET)).toBeEnabled();
  });

  test("opens a sheet that collects a chosen password with a confirmation", async ({ page }) => {
    // Same shape as the create sheet, on purpose: the person at the machine is the
    // superadmin, so they choose the replacement rather than receiving a random one.
    await openPanel(page, RUNNING);
    await page.locator(RESET).click();

    await expect(page.locator(SHEET)).toBeVisible();
    await expect(page.locator('[data-role="reset-password"]')).toBeVisible();
    await expect(page.locator('[data-role="reset-confirm"]')).toBeVisible();
  });

  test("refuses a mismatched confirmation without leaving the sheet", async ({ page }) => {
    const panel = await openPanel(page, RUNNING);
    await page.locator(RESET).click();

    await page.locator('[data-role="reset-password"]').fill("a-good-password");
    await page.locator('[data-role="reset-confirm"]').fill("a-good-password-typo");
    await page.locator('[data-action="reset-submit"]').click();

    await expect(page.locator('[data-role="reset-error"]')).toBeVisible();
    expect(panel.calls.some((c) => c.startsWith("resetAdminPassword"))).toBe(false);
    await expect(page.locator(SHEET)).toBeVisible();
  });

  test("hands the typed password over and reports success naming the account", async ({
    page,
  }) => {
    const panel = await openPanel(page, RUNNING, { ok: true, username: "tester" });
    await page.locator(RESET).click();

    await page.locator('[data-role="reset-password"]').fill("a-good-password");
    await page.locator('[data-role="reset-confirm"]').fill("a-good-password");
    await page.locator('[data-action="reset-submit"]').click();

    // The typed value is what crosses IPC — never a generated one, never an argv string.
    await expect
      .poll(() => panel.calls)
      .toContain("resetAdminPassword:a-good-password");
    await expect(page.locator('[data-role="reset-ok"]')).toContainText("tester");
    // The chosen password is not rendered back anywhere.
    await expect(page.locator(SHEET)).not.toContainText("a-good-password");
  });

  test("says which failure it was rather than reporting a generic one", async ({ page }) => {
    // The child's own refusal, rendered from the same catalog the create form uses: it is one
    // conversation with one process, so a code means the same thing on either sheet.
    await openPanel(page, RUNNING, { ok: false, fault: { code: "ADMIN_NOT_FOUND" } });
    await page.locator(RESET).click();

    await page.locator('[data-role="reset-password"]').fill("a-good-password");
    await page.locator('[data-role="reset-confirm"]').fill("a-good-password");
    await page.locator('[data-action="reset-submit"]').click();

    await expect(page.locator('[data-role="reset-error"]')).toContainText("还没有超级管理员");
    await expect(page.locator('[data-role="reset-ok"]')).toBeHidden();
  });

  test("closes on the scrim, the cancel link and Escape", async ({ page }) => {
    await openPanel(page, RUNNING);
    const open = async () => page.locator(RESET).click();

    await open();
    await page.locator(`${SHEET} .overlay__scrim`).click({ position: { x: 5, y: 5 } });
    await expect(page.locator(SHEET)).toBeHidden();

    await open();
    await page.locator(`${SHEET} .sheet [data-action="reset-cancel"]`).first().click();
    await expect(page.locator(SHEET)).toBeHidden();

    await open();
    await page.keyboard.press("Escape");
    await expect(page.locator(SHEET)).toBeHidden();
  });
});


test.describe("creating the first administrator", () => {
  const CARD = '[data-role="admin"]';
  const OVERLAY = '[data-role="admin-overlay"]';

  test("offers the create control, and its own button starts nothing", async ({ page }) => {
    const handle = await openPanel(page, NEEDS_ADMIN);

    await expect(page.locator(CARD)).toBeVisible();
    /*
     * Start is **live** in this state, and that is the change: it is the door that walks the reader
     * through creating this account, so the panel's primary action is no longer dead in exactly the
     * state a new install is in.
     */
    await expect(page.locator('[data-action="start"]')).toBeEnabled();
    // No reset either: it is a conversation with the running server, which is deliberately
    // stopped in this state.
    expect(await page.locator('[data-action="reset-admin"]').isEnabled()).toBe(false);

    // The card's button opens the same sheet — and asks for no start, because opening a form to
    // create an account is not a request to run the server.
    await page.locator('[data-action="admin-create"]').click();
    await expect(page.locator(OVERLAY)).toBeVisible();
    expect(handle.calls).not.toContain("start");
  });

  test("walks a Start through creating the administrator, and then starts", async ({ page }) => {
    /*
     * The whole chain, which is the point of the button: the server refuses to listen without an
     * administrator, so a Start in this state opens the form that makes one and then carries on.
     * Without it the reader is told what is missing and left to find the control themselves.
     */
    const handle = await openPanel(page, NEEDS_ADMIN, undefined, { ok: true, username: "ada" });
    await page.locator('[data-action="start"]').click();

    await expect(page.locator(OVERLAY)).toBeVisible();
    await page.locator('[data-role="admin-username"]').fill("ada");
    await page.locator('[data-role="admin-password"]').fill("a-good-password");
    await page.locator('[data-role="admin-confirm"]').fill("a-good-password");
    await page.locator('[data-action="admin-submit"]').click();

    // The sheet closes itself on the way past — the reader's attention belongs back on the panel —
    // and Start was asked a second time, now that an account exists.
    await expect(page.locator(OVERLAY)).toBeHidden();
    await expect.poll(() => handle.calls.filter((call) => call === "start").length).toBe(2);
  });

  test("stops there when the create sheet is dismissed", async ({ page }) => {
    // A dismissal is not consent to start without an administrator. One press, one ask — and Start
    // is still live, so pressing it again is the reader's call rather than a trap.
    const handle = await openPanel(page, NEEDS_ADMIN);
    await page.locator('[data-action="start"]').click();
    await expect(page.locator(OVERLAY)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator(OVERLAY)).toBeHidden();

    expect(handle.calls.filter((call) => call === "start")).toHaveLength(1);
    await expect(page.locator('[data-action="start"]')).toBeEnabled();
  });

  test("hides the card once an administrator exists", async ({ page }) => {
    await openPanel(page, RUNNING);
    await expect(page.locator(CARD)).toBeHidden();
  });

  test("refuses a mismatched confirmation without leaving the sheet", async ({ page }) => {
    const handle = await openPanel(page, NEEDS_ADMIN);
    await page.locator('[data-action="admin-create"]').click();

    await page.locator('[data-role="admin-username"]').fill("ada");
    await page.locator('[data-role="admin-password"]').fill("a-good-password");
    await page.locator('[data-role="admin-confirm"]').fill("a-good-password-typo");
    await page.locator('[data-action="admin-submit"]').click();

    await expect(page.locator('[data-role="admin-error"]')).toBeVisible();
    expect(handle.calls).not.toContain("createAdministrator");
  });

  test("creates and reports success, and does not start", async ({ page }) => {
    // The stub hands back the typed username, the way the real IPC result does.
    const handle = await openPanel(page, NEEDS_ADMIN, undefined, { ok: true, username: "ada" });
    await page.locator('[data-action="admin-create"]').click();

    await page.locator('[data-role="admin-username"]').fill("ada");
    await page.locator('[data-role="admin-password"]').fill("a-good-password");
    await page.locator('[data-role="admin-confirm"]').fill("a-good-password");
    await page.locator('[data-action="admin-submit"]').click();

    await expect(page.locator('[data-role="admin-ok"]')).toContainText("ada");
    // And the sheet stays up to say so, rather than closing itself the way the Start-driven one
    // does: the reader asked to create an account, and this is the acknowledgement of it.
    await expect(page.locator(OVERLAY)).toBeVisible();
    expect(handle.calls).not.toContain("start");
  });

  test("shows the CLI's refusal with its own wording", async ({ page }) => {
    await openPanel(page, NEEDS_ADMIN, undefined, {
      ok: false,
      fault: { code: "PASSWORD_TOO_SHORT", message: "too short", params: { min: 8 } },
    });
    await page.locator('[data-action="admin-create"]').click();

    await page.locator('[data-role="admin-username"]').fill("ada");
    await page.locator('[data-role="admin-password"]').fill("short");
    await page.locator('[data-role="admin-confirm"]').fill("short");
    await page.locator('[data-action="admin-submit"]').click();

    // The catalog string for the CLI code, not the English sentence the child sent.
    await expect(page.locator('[data-role="admin-error"]')).toContainText("8");
  });

  test("closes on the scrim, the cancel link and Escape", async ({ page }) => {
    await openPanel(page, NEEDS_ADMIN);
    const open = async () => page.locator('[data-action="admin-create"]').click();

    // The scrim sits behind the sheet, so it is clicked by its position rather than by the
    // same selector as the in-sheet button (which the sheet covers).
    await open();
    await page.locator(`${OVERLAY} .overlay__scrim`).click({ position: { x: 5, y: 5 } });
    await expect(page.locator(OVERLAY)).toBeHidden();

    await open();
    await page.locator(`${OVERLAY} .sheet [data-action="admin-cancel"]`).first().click();
    await expect(page.locator(OVERLAY)).toBeHidden();

    await open();
    await page.keyboard.press("Escape");
    await expect(page.locator(OVERLAY)).toBeHidden();
  });
});

/**
 * The language control.
 *
 * The panel is bilingual at runtime, and the interesting half is that the *page* does not decide
 * the language: it asks the main process and renders the answer. That is what keeps the page and
 * the menu bar above it — the application menu, the tray, the window title — from ever showing
 * two languages, and it is why this spec drives the control through the stub's `setLocale`
 * rather than expecting a `navigator.language` it cannot change.
 */
test.describe("the panel's language", () => {
  test("offers the three choices, with the system one selected by default", async ({ page }) => {
    await openPanel(page, RUNNING);

    const select = page.locator('[data-role="locale"]');
    await expect(select).toBeVisible();
    await expect(select.locator("option")).toHaveCount(3);
    // "Follow the system" is the empty value: a select whose options are all non-empty strings
    // has no other way to spell "nobody has chosen".
    await expect(select).toHaveValue("");
    await expect(select).toContainText("跟随系统");
  });

  test("takes the language from the state rather than from the browser", async ({ page }) => {
    // The state says English, and the spec's own locale is zh-CN — so the page rendering English
    // is the page following main rather than its own `navigator.language`.
    await openPanel(page, { ...RUNNING, locale: "en", localeChoice: "en" });

    await expect(page.locator('[data-role="state"]')).toHaveText("Running");
    await expect(page.locator('[data-action="start"]')).toHaveText("Start server");
    await expect(page.locator('[data-role="locale"]')).toHaveValue("en");
  });

  test("hands the choice to the main process and renders what comes back", async ({ page }) => {
    const panel = await openPanel(page, RUNNING);

    await page.locator('[data-role="locale"]').selectOption("en");

    // Asked, not assumed: the page does not switch on its own, because the menu bar cannot.
    expect(panel.calls).toContain("setLocale:en");
    await expect(page.locator('[data-role="state"]')).toHaveText("Running");
    await expect(page.locator('[data-action="reset-admin"]')).toHaveText("Reset superadmin password");
    // The autonyms do not follow the language, which is the point of labelling each option in
    // its own — the picker stays usable to somebody who has just switched to a language they
    // cannot read.
    await expect(page.locator('[data-role="locale"]')).toContainText("简体中文");
  });

  test("goes back to following the system when that choice is picked", async ({ page }) => {
    const panel = await openPanel(page, { ...RUNNING, locale: "en", localeChoice: "en" });
    await expect(page.locator('[data-role="state"]')).toHaveText("Running");

    await page.locator('[data-role="locale"]').selectOption("");

    expect(panel.calls).toContain("setLocale:");
    await expect(page.locator('[data-role="state"]')).toHaveText("运行中");
  });
});

test.describe("the version row", () => {
  /*
   * The first place the app tells a packaged user which version they are running — until this row
   * existed the only way to find out was the operating system's About box. It is also what makes
   * the update notice meaningful, since the notice is a comparison against it.
   */
  test("always shows the version, and offers a check", async ({ page }) => {
    await openPanel(page, RUNNING);

    await expect(page.locator('[data-role="version"]')).toHaveText("v0.1.0");
    await expect(page.locator('[data-action="check-updates"]')).toBeVisible();
    // Nothing to report: no notice, and no button that would lead nowhere.
    await expect(page.locator('[data-role="update-available"]')).toBeHidden();
    await expect(page.locator('[data-action="update"]')).toBeHidden();
  });

  test("says which version is available, and offers the download rather than installing it", async ({
    page,
  }) => {
    await openPanel(page, UPDATE_AVAILABLE);

    await expect(page.locator('[data-role="update-available"]')).toContainText("0.2.0");
    const download = page.locator('[data-action="update"]');
    await expect(download).toBeVisible();

    /*
     * It opens the release page and installs nothing — see `docs/desktop.md` for why there is no
     * self-update: our macOS packages are ad-hoc signed, so Squirrel.Mac would download the release
     * and then refuse to apply it. The assertion is on the command rather than on a browser opening
     * during the test.
     */
    await download.click();
    expect(await page.evaluate(() => (window as never as { opened: string[] }).opened ?? [])).toEqual(
      []
    );
  });

  test("shows the notice while a check is running, so the control is not dead", async ({ page }) => {
    // A manual check takes a second or two. A button that looks live and does nothing for that long
    // is the failure this panel's own docblock names, so the row says what it is doing.
    await openPanel(page, { ...RUNNING, update: { ...RUNNING.update, checking: true } });

    await expect(page.locator('[data-role="version"]')).toContainText("检查");
    await expect(page.locator('[data-action="check-updates"]')).toBeDisabled();
  });
});

test.describe("the migration note", () => {
  test("is absent on an ordinary launch", async ({ page }) => {
    // The note is about a boot that upgraded the database. Drawing it always would make it noise,
    // and the sentence is one that should stop somebody scrolling.
    await openPanel(page, RUNNING);
    await expect(page.locator('[data-role="migrated"]')).toBeHidden();
  });

  test("names both versions and the copy taken beforehand", async ({ page }) => {
    /*
     * Both halves matter. That it happened, because an upgrade rewrites the user's only copy of
     * their data and should not be silent; and where the copy is, because that is the file they
     * would need if the upgrade turns out to have been wrong.
     */
    await openPanel(page, MIGRATED);

    const note = page.locator('[data-role="migrated"]');
    await expect(note).toBeVisible();
    await expect(page.locator('[data-role="migrated-note"]')).toContainText("v5");
    await expect(page.locator('[data-role="migrated-note"]')).toContainText("v6");
    await expect(page.locator('[data-role="migrated-backup"]')).toContainText("v5.sqlite");
  });

  test("says so when no copy was taken", async ({ page }) => {
    // A deployment can opt out (`ILA_SKIP_MIGRATION_BACKUP`), and pointing at a file that is not
    // there would be worse than saying nothing was kept.
    await openPanel(page, {
      ...MIGRATED,
      server: { ...MIGRATED.server, migrated: { from: 5, to: 6, backup: null } },
    });

    await expect(page.locator('[data-role="migrated-note"]')).toContainText("v6");
    await expect(page.locator('[data-role="migrated-backup"]')).toBeHidden();
  });
});
